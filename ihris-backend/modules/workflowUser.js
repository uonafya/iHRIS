const nconf = require('./config')
const user = require('./user')
const logger = require('../winston')
const crypto = require('crypto')
const fhirAxios = nconf.fhirAxios

let locationRoleID = undefined

const workflowUser = {
  process: ( req ) => {
    return new Promise( async (resolve, reject) => {
      try {
        let bundle = {
          resourceType: "Bundle",
          type: "transaction",
          entry: []
        }
        let personLink = req.body && req.body.item && req.body.item.find(item => item.linkId === "Person")
        if(!personLink) {
          return reject()
        }
        let personNameLink = personLink.item && personLink.item.find(item => item.linkId === "Person.name[0].text")
        if(!personNameLink || !personNameLink.answer || personNameLink.answer.length === 0) {
          return reject()
        }
        let personTelecomLink = personLink.item && personLink.item.find(item => item.linkId === "Person.telecom[0].value")
        if(!personTelecomLink || !personTelecomLink.answer || personTelecomLink.answer.length === 0) {
          return reject()
        }

        let userEmail = personTelecomLink.answer[0].valueString
        let userRoles = undefined
        let constraint = undefined
        let hasLocation = false
        let userRoleId = undefined
        let extensions = []
        user.lookupByEmail(userEmail).then( async (userObj) =>  {
          if ( !userObj ) {
            let personLocationLink = personLink.item && personLink.item.find(item => item.linkId === "location")
            if(personLocationLink && personLocationLink.answer && personLocationLink.answer.length > 0 && personLocationLink.answer[0].valueReference) {
              try {
                userRoles = await fhirAxios.search("Basic", { locationconstraint: "related-location=" + personLocationLink.answer[0].valueReference  })
              } catch (err) {
                logger.error("Error Getting user roles for user" + userEmail)
                resolve(await workflowUser.outcome("Error Getting user roles for user " + userEmail))
              }
              let locationValueReference = personLocationLink.answer[0].valueReference.reference
              if(userRoles.entry){
                userRoleId = userRoles.entry[0].resource.id
                extensions.push({ url: "http://ihris.org/fhir/StructureDefinition/ihris-assign-role",
                valueReference: { reference: "Basic/" + userRoleId}
                })
              } else {
                let newRole = undefined
                try {
                  newRole = await workflowUser.createLocationRole(locationValueReference)
                } catch (error) {
                  logger.error("Error creating new role for " + locationValueReference)
                  resolve(await workflowUser.outcome("Error creating new role for " +locationValueReference))
                }
                let roleURL = "Basic/"+locationRoleID
                bundle.entry.push( {
                  resource: newRole,
                  request: {
                    method: "PUT",
                    url: roleURL
                  }
                })

                extensions.push({ url: "http://ihris.org/fhir/StructureDefinition/ihris-assign-role",
                valueReference: { reference: "Basic/" +locationRoleID}
                })
              }
              extensions.push({ url: "http://ihris.org/fhir/StructureDefinition/ihris-user-location",
              valueReference:personLocationLink.answer[0].valueReference
                      })
              let primaryLocationID = locationValueReference.split("/")
              //logger.info("PRIMARY ID",primaryLocationID )
              let relatedExt = []
              //let relatedLocations = []
              try {
                let relatedLocationsBundle  = await fhirAxios.search( "Location",
                  { _id: primaryLocationID[1], status: "active", "_include:iterate": "Location:partof" } )
                for( let entry of relatedLocationsBundle.entry ) {
                  relatedExt.push({ url:"location",
                          valueString: "Location/" + entry.resource.id
                          })
                }
              } catch (err) {
                logger.error("Failed to get related locations for ",primaryLocationID[1] )
                resolve(await workflowUser.outcome("Failed to Find location "+primaryLocationID[1]))
              }
              extensions.push({ url: "http://ihris.org/fhir/StructureDefinition/ihris-related-group",
              extension:relatedExt
                      })
            }
            let personRoleLink = personLink.item && personLink.item.find(item => item.linkId === "role")
            if(personRoleLink && personRoleLink.answer && personRoleLink.answer.length > 0 && personRoleLink.answer[0].valueReference) {
              extensions.push({ url: "http://ihris.org/fhir/StructureDefinition/ihris-assign-role",
              valueReference: personRoleLink.answer[0].valueReference
              })
            }
            let personPassLink = personLink.item && personLink.item.find(item => item.linkId === "password")
            if(personPassLink && personPassLink.answer && personPassLink.answer.length > 0 && personPassLink.answer[0].valueString) {
              try {
                // user.hashPassword(req.body.item[0].item[6].answer[0].valueString).then((hashedPassword) => {
                let passwordExt = []
                let password = personPassLink.answer[0].valueString
                let salt = crypto.randomBytes(16).toString('hex')
                let hash = crypto.pbkdf2Sync( password, salt, 1000, 64, 'sha512' ).toString('hex')
                passwordExt.push({ url:"password",
                  valueString: hash
                })
                passwordExt.push({ url:"salt",
                  valueString: salt
                })
                extensions.push({ url: "http://ihris.org/fhir/StructureDefinition/ihris-password",
                  extension : passwordExt
                })
                // })
              } catch (err) {
                logger.error("Error setting Password ")
                reject(err)
              }

            } else {
              logger.info("NO PASSWORD SET ")
              resolve(await workflowUser.outcome("No Password set for this User"))
            }
            let userName = userEmail.split('@')
            let newUser = {
              resourceType: "Person",
              id: "ihris-user-"+userName[0],
              meta: {
                profile: ["http://ihris.org/fhir/StructureDefinition/ihris-person-user"]
              },
              extension: extensions,
              name: [
                {
                  use: "official",
                  text: personNameLink.answer[0].valueString
                }
              ],
              telecom:[
                {
                  system: "email",
                  value: userEmail
                }
              ]
            }
            let url = "Person/ihris-user-"+userName[0]
            bundle.entry.push( {
              resource: newUser,
              request: {
                method: "PUT",
                url: url
              }
            })
          } else {
            logger.error("User " + userEmail + " Exist")
            resolve(await workflowUser.outcome("User " + userEmail + " Exist"))
            //reject(err.message)
          }
          resolve(bundle)
        }).catch( (err) => {
          reject( err.message )
        })
      } catch (err){
        logger.error(err)
        reject(err.message)
      }
    })
  },
  postProcess: ( req, results ) => {
    return new Promise( (resolve, reject) => {
        if ( results.entry && results.entry.length > 0 && results.entry[1].response.location ) {
          if ( !req.body.meta ) req.body.meta = {}
          if ( !req.body.meta.tag ) req.body.meta.tag = []
          req.body.meta.tag.push( { system: "http://ihris.org/fhir/tags/resource", code: results.entry[1].response.location } )
          resolve( req )
        }
    })
  },
  createLocationRole:( locationReference) => {
    return new Promise( (resolve, reject) => {
      try {
        let locationID = locationReference.split("/")
        fhirAxios.search("Location", { _id: locationID[1]}).then ((locationResource) => {
        let locationName = locationResource.entry[0].resource.name
        let extensions = []
        extensions.push({ url: "http://ihris.org/fhir/StructureDefinition/ihris-basic-name",
          valueString: locationName},
        {
          url: "http://ihris.org/fhir/StructureDefinition/ihris-role-primary",
          valueBoolean: false
        }, {
          url: "http://ihris.org/fhir/StructureDefinition/ihris-task",
          extension: [ {
            url: "permission",
            valueCode: "read"
          }, {
            url: "resource",
            valueCode: "Location"
          } ]
        }, {
          url: "http://ihris.org/fhir/StructureDefinition/ihris-task",
          extension: [ {
            url: "permission",
            valueCode: "read"
          }, {
            url: "resource",
            valueCode: "Basic"
          }, {
            url: "instance",
            valueId: "ihris-page-practitioner"
          } ]
        }, {
          url: "http://ihris.org/fhir/StructureDefinition/ihris-task",
          extension: [ {
            url: "permission",
            valueCode: "read"
          }, {
            url: "resource",
            valueCode: "Basic"
          }, {
            url: "instance",
            valueId: "ihris-page-practitionerrole"
          } ]
        }, {
          url: "http://ihris.org/fhir/StructureDefinition/ihris-task",
          extension: [ {
            url: "permission",
            valueCode: "read"
          }, {
            url: "resource",
            valueCode: "Questionnaire"
          } ]
        }, {
          url: "http://ihris.org/fhir/StructureDefinition/ihris-task",
          extension: [ {
            url: "permission",
            valueCode: "write"
          }, {
            url: "resource",
            valueCode: "QuestionnaireResponse"
          } ]
        },
        {
          url: "http://ihris.org/fhir/StructureDefinition/ihris-task",
          extension: [ {
            url: "permission",
            valueCode: "*"
          }, {
            url: "resource",
            valueCode: "*"
          }, {
            url: "constraint",
            valueString: "extension.where(url = 'http://ihris.org/fhir/StructureDefinition/ihris-related-group' ).extension.exists( url = 'location' and valueString = '" +locationReference+"')"
          } ]
        },{
          url: "http://ihris.org/fhir/StructureDefinition/ihris-task",
          extension: [ {
            url: "permission",
            valueCode: "filter"
          }, {
            url: "resource",
            valueCode: "Person"
          }, {
            url: "constraint",
            valueString: "related-location="+locationReference
          } ]
        },{
          url: "http://ihris.org/fhir/StructureDefinition/ihris-task",
          extension: [ {
            url: "permission",
            valueCode: "filter"
          }, {
            url: "resource",
            valueCode: "Practitioner"
          }, {
            url: "constraint",
            valueString: "related-location="+locationReference
          } ]
        }, {
          url: "http://ihris.org/fhir/StructureDefinition/ihris-task",
          extension: [ {
            url: "permission",
            valueCode: "filter"
          }, {
            url: "resource",
            valueCode: "PractitionerRole"
          }, {
            url: "constraint",
            valueString: "related-location="+locationReference
          } ]
        },
        {
          url: "http://ihris.org/fhir/StructureDefinition/ihris-assign-role",
          valueReference: {
            reference: "Basic/ihris-role-open"
          }
        })
        locationRoleID = "ihris-role-location-based-"+locationName.replace(/\s/g,"").toLowerCase()
        let newRole = {
          resourceType: "Basic",
          id: locationRoleID ,
          meta: {
            profile: [ "http://ihris.org/fhir/StructureDefinition/ihris-role" ]
          },
          extension: extensions,
        }
        resolve (newRole)
        }).catch( (err) => {
          console.error( err )
          reject( err )
        } )
      } catch (err) {
        logger.error("Error creating location role for " + locationReference )
        reject(err.message)
      }
    })
  },
  outcome: (message) => {
    return new Promise ((resolve, reject ) => {
      let outcomeBundle = {
        resourceType: "Bundle",
        type: "transaction",
        entry: [{
          resource:{
            resourceType: "OperationOutcome",
            issue: [
            {
              severity: "error",
              code: "exception",
              diagnostics: message
            }]
          },
          request: {
            method: "POST",
            url: "OperationOutcome"
          }
        }]
      }
      logger.info(JSON.stringify(outcomeBundle,null,2))
      resolve(outcomeBundle)
    })
  }
}
module.exports = workflowUser